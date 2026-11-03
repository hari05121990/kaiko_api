-- =============================================================================
-- Kaiko Kart – ROLLBACK for Migration 008 (review copy – NOT a migration)
-- =============================================================================
-- Restores the exact pre-008 state captured on 2026-11-02:
--   1. Drops the six functions added by 008. Any data they wrote (profiles,
--      user_roles, wallets, order status changes, audit rows) is KEPT.
--   2. Restores the original definitions of the six replaced functions
--      (verbatim pg_get_functiondef output). ACLs are unchanged by
--      CREATE OR REPLACE, so function grants need no restore.
--   3. Re-grants exactly the table privileges 008 revoked.
-- Run as postgres. Single transaction.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.admin_create_customer_profile(uuid, text, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.admin_list_customers(text, text, integer, integer);
DROP FUNCTION IF EXISTS public.admin_get_customer(uuid);
DROP FUNCTION IF EXISTS public.admin_update_customer(uuid, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.admin_set_customer_status(uuid, text, text);
DROP FUNCTION IF EXISTS public.admin_update_order_status(uuid, text, text);

CREATE OR REPLACE FUNCTION public.has_global_admin_role()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = (SELECT auth.uid())
          AND ur.role IN ('SUPER_ADMIN', 'ADMIN')
          AND ur.store_id IS NULL
    );
$function$;

CREATE OR REPLACE FUNCTION public.is_staff_or_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = (SELECT auth.uid())
          AND ur.role IN ('SUPER_ADMIN', 'ADMIN', 'STAFF')
    );
$function$;

CREATE OR REPLACE FUNCTION public.can_access_store(p_store_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = (SELECT auth.uid())
          AND (
              (
                  ur.role IN ('SUPER_ADMIN', 'ADMIN')
                  AND (
                      ur.store_id IS NULL
                      OR ur.store_id = p_store_id
                  )
              )
              OR
              (
                  ur.role = 'STAFF'
                  AND ur.store_id = p_store_id
              )
          )
    );
$function$;

CREATE OR REPLACE FUNCTION public.admin_credit_points(p_customer_id uuid, p_purchase_amount numeric, p_idempotency_key text, p_reference_id uuid DEFAULT NULL::uuid, p_description text DEFAULT NULL::text)
 RETURNS TABLE(transaction_id uuid, wallet_id uuid, points_credited bigint, new_balance bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_admin_id uuid;
    v_wallet_id uuid;
    v_transaction_id uuid;
    v_points bigint;
    v_old_balance bigint;
    v_new_balance bigint;
    v_existing_type text;
    v_existing_wallet uuid;
    v_existing_points bigint;
    v_existing_amount numeric;
    v_existing_balance bigint;
    v_description text;
BEGIN
    v_admin_id := auth.uid();

    IF v_admin_id IS NULL
       OR NOT public.has_global_admin_role() THEN
        RAISE EXCEPTION 'Not authorised to credit reward points';
    END IF;

    IF p_customer_id IS NULL THEN
        RAISE EXCEPTION 'Customer ID is required';
    END IF;

    IF p_purchase_amount IS NULL OR p_purchase_amount <= 0 THEN
        RAISE EXCEPTION 'Purchase amount must be greater than zero';
    END IF;

    IF p_idempotency_key IS NULL
       OR pg_catalog.length(pg_catalog.btrim(p_idempotency_key)) = 0
       OR pg_catalog.length(p_idempotency_key) > 200 THEN
        RAISE EXCEPTION 'A valid idempotency key is required';
    END IF;

    v_points := pg_catalog.floor(p_purchase_amount / 100)::bigint;

    IF v_points <= 0 THEN
        RAISE EXCEPTION 'Purchase amount must be at least Rs.100 to earn points';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = p_customer_id
          AND p.status = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'Customer does not exist or is inactive';
    END IF;

    v_description := COALESCE(
        NULLIF(pg_catalog.btrim(p_description), ''),
        'Reward points for eligible purchase'
    );

    -- Prevent concurrent requests using the same key.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_idempotency_key, 0)
    );

    -- Return the original result if this exact request was already processed.
    SELECT
        rt.id,
        rt.wallet_id,
        rt.points,
        rt.purchase_amount,
        rt.transaction_type,
        rw.balance
    INTO
        v_transaction_id,
        v_existing_wallet,
        v_existing_points,
        v_existing_amount,
        v_existing_type,
        v_existing_balance
    FROM public.reward_transactions rt
    JOIN public.reward_wallets rw ON rw.id = rt.wallet_id
    WHERE rt.idempotency_key = p_idempotency_key;

    IF FOUND THEN
        IF v_existing_type <> 'CREDIT'
           OR v_existing_amount IS DISTINCT FROM p_purchase_amount
           OR NOT EXISTS (
               SELECT 1
               FROM public.reward_wallets rw
               WHERE rw.id = v_existing_wallet
                 AND rw.customer_id = p_customer_id
           ) THEN
            RAISE EXCEPTION 'Idempotency key already used for a different transaction';
        END IF;

        transaction_id := v_transaction_id;
        wallet_id := v_existing_wallet;
        points_credited := v_existing_points;
        new_balance := v_existing_balance;
        RETURN NEXT;
        RETURN;
    END IF;

    -- Create wallet if it does not exist.
    INSERT INTO public.reward_wallets (customer_id, balance)
    VALUES (p_customer_id, 0)
    ON CONFLICT (customer_id) DO NOTHING;

    -- Lock wallet before changing its balance.
    SELECT rw.id, rw.balance
    INTO v_wallet_id, v_old_balance
    FROM public.reward_wallets rw
    WHERE rw.customer_id = p_customer_id
    FOR UPDATE;

    INSERT INTO public.reward_transactions (
        wallet_id,
        transaction_type,
        points,
        reference_type,
        reference_id,
        purchase_amount,
        description,
        idempotency_key,
        created_by
    )
    VALUES (
        v_wallet_id,
        'CREDIT',
        v_points,
        'PURCHASE',
        p_reference_id,
        p_purchase_amount,
        v_description,
        p_idempotency_key,
        v_admin_id
    )
    RETURNING id INTO v_transaction_id;

    UPDATE public.reward_wallets
    SET balance = balance + v_points,
        updated_at = pg_catalog.now()
    WHERE id = v_wallet_id
    RETURNING balance INTO v_new_balance;

    INSERT INTO public.admin_audit_logs (
        admin_id,
        action,
        entity_type,
        entity_id,
        old_data,
        new_data
    )
    VALUES (
        v_admin_id,
        'REWARD_POINTS_CREDITED',
        'reward_transactions',
        v_transaction_id,
        pg_catalog.jsonb_build_object(
            'balance', v_old_balance
        ),
        pg_catalog.jsonb_build_object(
            'customer_id', p_customer_id,
            'purchase_amount', p_purchase_amount,
            'points', v_points,
            'balance', v_new_balance
        )
    );

    transaction_id := v_transaction_id;
    wallet_id := v_wallet_id;
    points_credited := v_points;
    new_balance := v_new_balance;

    RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_adjust_points(p_customer_id uuid, p_direction text, p_points bigint, p_reason text, p_idempotency_key text)
 RETURNS TABLE(transaction_id uuid, wallet_id uuid, adjusted_points bigint, new_balance bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_admin_id uuid;
    v_wallet_id uuid;
    v_transaction_id uuid;
    v_old_balance bigint;
    v_new_balance bigint;
    v_description text;
    v_reference_type text;
    v_existing_type text;
    v_existing_wallet uuid;
    v_existing_points bigint;
    v_existing_reference text;
    v_existing_description text;
    v_existing_balance bigint;
BEGIN
    v_admin_id := auth.uid();

    IF v_admin_id IS NULL
       OR NOT public.has_global_admin_role() THEN
        RAISE EXCEPTION 'Not authorised to adjust reward points';
    END IF;

    IF p_customer_id IS NULL THEN
        RAISE EXCEPTION 'Customer ID is required';
    END IF;

    IF p_direction NOT IN ('CREDIT', 'DEBIT') THEN
        RAISE EXCEPTION 'Direction must be CREDIT or DEBIT';
    END IF;

    IF p_points IS NULL OR p_points <= 0 THEN
        RAISE EXCEPTION 'Points must be greater than zero';
    END IF;

    IF p_reason IS NULL
       OR pg_catalog.length(pg_catalog.btrim(p_reason)) = 0 THEN
        RAISE EXCEPTION 'Adjustment reason is mandatory';
    END IF;

    IF p_idempotency_key IS NULL
       OR pg_catalog.length(pg_catalog.btrim(p_idempotency_key)) = 0
       OR pg_catalog.length(p_idempotency_key) > 200 THEN
        RAISE EXCEPTION 'A valid idempotency key is required';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = p_customer_id
          AND p.status = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'Customer does not exist or is inactive';
    END IF;

    v_reference_type := 'ADJUSTMENT_' || p_direction;
    v_description := p_direction || ': ' || pg_catalog.btrim(p_reason);

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_idempotency_key, 0)
    );

    SELECT
        rt.id,
        rt.wallet_id,
        rt.points,
        rt.transaction_type,
        rt.reference_type,
        rt.description,
        rw.balance
    INTO
        v_transaction_id,
        v_existing_wallet,
        v_existing_points,
        v_existing_type,
        v_existing_reference,
        v_existing_description,
        v_existing_balance
    FROM public.reward_transactions rt
    JOIN public.reward_wallets rw ON rw.id = rt.wallet_id
    WHERE rt.idempotency_key = p_idempotency_key;

    IF FOUND THEN
        IF v_existing_type <> 'ADJUSTMENT'
           OR v_existing_points <> p_points
           OR v_existing_reference <> v_reference_type
           OR v_existing_description <> v_description
           OR NOT EXISTS (
               SELECT 1
               FROM public.reward_wallets rw
               WHERE rw.id = v_existing_wallet
                 AND rw.customer_id = p_customer_id
           ) THEN
            RAISE EXCEPTION 'Idempotency key already used for a different transaction';
        END IF;

        transaction_id := v_transaction_id;
        wallet_id := v_existing_wallet;
        adjusted_points := v_existing_points;
        new_balance := v_existing_balance;
        RETURN NEXT;
        RETURN;
    END IF;

    INSERT INTO public.reward_wallets (customer_id, balance)
    VALUES (p_customer_id, 0)
    ON CONFLICT (customer_id) DO NOTHING;

    SELECT rw.id, rw.balance
    INTO v_wallet_id, v_old_balance
    FROM public.reward_wallets rw
    WHERE rw.customer_id = p_customer_id
    FOR UPDATE;

    IF p_direction = 'DEBIT' AND v_old_balance < p_points THEN
        RAISE EXCEPTION 'Insufficient reward points for adjustment';
    END IF;

    INSERT INTO public.reward_transactions (
        wallet_id,
        transaction_type,
        points,
        reference_type,
        description,
        idempotency_key,
        created_by
    )
    VALUES (
        v_wallet_id,
        'ADJUSTMENT',
        p_points,
        v_reference_type,
        v_description,
        p_idempotency_key,
        v_admin_id
    )
    RETURNING id INTO v_transaction_id;

    UPDATE public.reward_wallets
    SET balance = CASE
            WHEN p_direction = 'CREDIT' THEN balance + p_points
            ELSE balance - p_points
        END,
        updated_at = pg_catalog.now()
    WHERE id = v_wallet_id
    RETURNING balance INTO v_new_balance;

    INSERT INTO public.admin_audit_logs (
        admin_id,
        action,
        entity_type,
        entity_id,
        old_data,
        new_data
    )
    VALUES (
        v_admin_id,
        'REWARD_POINTS_ADJUSTED',
        'reward_transactions',
        v_transaction_id,
        pg_catalog.jsonb_build_object(
            'balance', v_old_balance
        ),
        pg_catalog.jsonb_build_object(
            'customer_id', p_customer_id,
            'direction', p_direction,
            'points', p_points,
            'reason', p_reason,
            'balance', v_new_balance
        )
    );

    transaction_id := v_transaction_id;
    wallet_id := v_wallet_id;
    adjusted_points := p_points;
    new_balance := v_new_balance;

    RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_reverse_points(p_original_transaction_id uuid, p_idempotency_key text, p_reason text)
 RETURNS TABLE(transaction_id uuid, wallet_id uuid, reversed_points bigint, new_balance bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_admin_id uuid;
    v_original_wallet_id uuid;
    v_customer_id uuid;
    v_original_points bigint;
    v_original_amount numeric;
    v_original_type text;
    v_transaction_id uuid;
    v_old_balance bigint;
    v_new_balance bigint;
    v_existing_wallet uuid;
    v_existing_points bigint;
    v_existing_reference uuid;
    v_existing_balance bigint;
    v_description text;
BEGIN
    v_admin_id := auth.uid();

    IF v_admin_id IS NULL
       OR NOT public.has_global_admin_role() THEN
        RAISE EXCEPTION 'Not authorised to reverse reward points';
    END IF;

    IF p_original_transaction_id IS NULL THEN
        RAISE EXCEPTION 'Original transaction ID is required';
    END IF;

    IF p_idempotency_key IS NULL
       OR pg_catalog.length(pg_catalog.btrim(p_idempotency_key)) = 0
       OR pg_catalog.length(p_idempotency_key) > 200 THEN
        RAISE EXCEPTION 'A valid idempotency key is required';
    END IF;

    IF p_reason IS NULL
       OR pg_catalog.length(pg_catalog.btrim(p_reason)) = 0 THEN
        RAISE EXCEPTION 'Reversal reason is mandatory';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_idempotency_key, 0)
    );

    -- Check whether this exact reversal request already exists.
    SELECT
        rt.id,
        rt.wallet_id,
        rt.points,
        rt.reference_id,
        rw.balance
    INTO
        v_transaction_id,
        v_existing_wallet,
        v_existing_points,
        v_existing_reference,
        v_existing_balance
    FROM public.reward_transactions rt
    JOIN public.reward_wallets rw ON rw.id = rt.wallet_id
    WHERE rt.idempotency_key = p_idempotency_key
      AND rt.transaction_type = 'REVERSAL';

    IF FOUND THEN
        IF v_existing_reference IS DISTINCT FROM p_original_transaction_id THEN
            RAISE EXCEPTION 'Idempotency key already used for a different reversal';
        END IF;

        transaction_id := v_transaction_id;
        wallet_id := v_existing_wallet;
        reversed_points := v_existing_points;
        new_balance := v_existing_balance;
        RETURN NEXT;
        RETURN;
    END IF;

    SELECT
        rt.wallet_id,
        rw.customer_id,
        rt.points,
        rt.purchase_amount,
        rt.transaction_type
    INTO
        v_original_wallet_id,
        v_customer_id,
        v_original_points,
        v_original_amount,
        v_original_type
    FROM public.reward_transactions rt
    JOIN public.reward_wallets rw ON rw.id = rt.wallet_id
    WHERE rt.id = p_original_transaction_id
    FOR UPDATE OF rt;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Original reward transaction not found';
    END IF;

    IF v_original_type <> 'CREDIT'
       OR v_original_amount IS NULL THEN
        RAISE EXCEPTION 'Only purchase credit transactions can be reversed';
    END IF;

    -- Do not permit a second full reversal under another key.
    IF EXISTS (
        SELECT 1
        FROM public.reward_transactions rt
        WHERE rt.transaction_type = 'REVERSAL'
          AND rt.reference_type = 'REWARD_REVERSAL'
          AND rt.reference_id = p_original_transaction_id
    ) THEN
        RAISE EXCEPTION 'This purchase credit has already been reversed';
    END IF;

    SELECT rw.balance
    INTO v_old_balance
    FROM public.reward_wallets rw
    WHERE rw.id = v_original_wallet_id
    FOR UPDATE;

    IF v_old_balance < v_original_points THEN
        RAISE EXCEPTION
            'Cannot reverse: customer has already used some of these points. Current balance: %, points to reverse: %',
            v_old_balance,
            v_original_points;
    END IF;

    v_description := 'Purchase credit reversal: ' || pg_catalog.btrim(p_reason);

    INSERT INTO public.reward_transactions (
        wallet_id,
        transaction_type,
        points,
        reference_type,
        reference_id,
        purchase_amount,
        description,
        idempotency_key,
        created_by
    )
    VALUES (
        v_original_wallet_id,
        'REVERSAL',
        v_original_points,
        'REWARD_REVERSAL',
        p_original_transaction_id,
        v_original_amount,
        v_description,
        p_idempotency_key,
        v_admin_id
    )
    RETURNING id INTO v_transaction_id;

    UPDATE public.reward_wallets
    SET balance = balance - v_original_points,
        updated_at = pg_catalog.now()
    WHERE id = v_original_wallet_id
    RETURNING balance INTO v_new_balance;

    INSERT INTO public.admin_audit_logs (
        admin_id,
        action,
        entity_type,
        entity_id,
        old_data,
        new_data
    )
    VALUES (
        v_admin_id,
        'REWARD_POINTS_REVERSED',
        'reward_transactions',
        v_transaction_id,
        pg_catalog.jsonb_build_object(
            'balance', v_old_balance
        ),
        pg_catalog.jsonb_build_object(
            'customer_id', v_customer_id,
            'original_transaction_id', p_original_transaction_id,
            'points_reversed', v_original_points,
            'reason', p_reason,
            'balance', v_new_balance
        )
    );

    transaction_id := v_transaction_id;
    wallet_id := v_original_wallet_id;
    reversed_points := v_original_points;
    new_balance := v_new_balance;

    RETURN NEXT;
END;
$function$;

-- Table privileges revoked by 008 (from the pre-008 grant inventory).
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.admin_audit_logs TO anon;
GRANT REFERENCES, TRIGGER, TRUNCATE ON TABLE public.admin_audit_logs TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.admin_permissions TO anon;
GRANT REFERENCES, TRIGGER, TRUNCATE ON TABLE public.admin_permissions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.app_settings TO anon;
GRANT REFERENCES, TRIGGER, TRUNCATE ON TABLE public.app_settings TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.categories TO anon;
GRANT REFERENCES, TRIGGER, TRUNCATE ON TABLE public.categories TO authenticated;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.inventory_transactions TO anon;
GRANT REFERENCES, TRIGGER, TRUNCATE ON TABLE public.inventory_transactions TO authenticated;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.order_items TO anon;
GRANT REFERENCES, TRIGGER, TRUNCATE ON TABLE public.order_items TO authenticated;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.order_status_history TO anon;
GRANT REFERENCES, TRIGGER, TRUNCATE ON TABLE public.order_status_history TO authenticated;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.orders TO anon;
GRANT REFERENCES, TRIGGER, TRUNCATE ON TABLE public.orders TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.product_images TO anon;
GRANT REFERENCES, TRIGGER, TRUNCATE ON TABLE public.product_images TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.products TO anon;
GRANT REFERENCES, TRIGGER, TRUNCATE ON TABLE public.products TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.store_products TO anon;
GRANT DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.store_products TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.stores TO anon;
GRANT REFERENCES, TRIGGER, TRUNCATE ON TABLE public.stores TO authenticated;
GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public.user_roles TO anon;
GRANT REFERENCES, TRIGGER, TRUNCATE ON TABLE public.user_roles TO authenticated;

COMMIT;
