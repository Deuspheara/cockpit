-- Serialize background financial writes with account removal, including requests
-- that fetched provider data before the account was archived.
CREATE FUNCTION require_active_account_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE archived boolean;
BEGIN
  SELECT is_archived INTO archived FROM accounts WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.account_id ELSE NEW.account_id END FOR SHARE;
  IF archived IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Account removed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['transactions','holding_observations','account_valuations',
    'provider_account_history','evm_balance_history','evm_account_history','recurring_rules',
    'reconciliation_items','csv_import_accounts'] LOOP
    EXECUTE format('CREATE TRIGGER active_account_write BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION require_active_account_write()', relation);
  END LOOP;
END;
$$;

-- Job termination remains writable; archived jobs cannot be restarted or advance.
CREATE FUNCTION prevent_archived_job_progress() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE archived boolean;
BEGIN
  SELECT is_archived INTO archived FROM accounts WHERE id=NEW.account_id FOR SHARE;
  IF archived AND NEW.status <> 'failed' THEN
    RAISE EXCEPTION 'Account removed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER active_sync_account BEFORE INSERT OR UPDATE ON sync_runs
  FOR EACH ROW EXECUTE FUNCTION prevent_archived_job_progress();
CREATE TRIGGER active_history_account BEFORE INSERT OR UPDATE ON evm_history_jobs
  FOR EACH ROW EXECUTE FUNCTION prevent_archived_job_progress();
