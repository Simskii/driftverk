ALTER TABLE sandbox_executions ADD COLUMN encrypted_environment TEXT;
ALTER TABLE sandbox_executions ADD COLUMN environment_iv TEXT;
ALTER TABLE sandbox_executions ADD CONSTRAINT execution_environment_pair CHECK ((encrypted_environment IS NULL) = (environment_iv IS NULL));
CREATE FUNCTION clear_finished_execution_secrets() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('queued', 'running') THEN
    NEW.encrypted_environment := NULL;
    NEW.environment_iv := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER clear_finished_execution_secrets BEFORE INSERT OR UPDATE ON sandbox_executions
FOR EACH ROW EXECUTE FUNCTION clear_finished_execution_secrets();
