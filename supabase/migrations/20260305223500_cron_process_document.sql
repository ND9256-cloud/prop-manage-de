-- Enable pg_cron and pg_net for scheduled HTTP calls
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Schedule process-document to run every minute
SELECT cron.schedule(
  'process-warehouse-jobs',
  '* * * * *',
  $$
    SELECT net.http_post(
      url := 'https://vatsmyvkeuxkcwemmxau.supabase.co/functions/v1/process-document',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  $$
);
