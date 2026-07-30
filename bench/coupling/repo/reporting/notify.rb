# Reads the SAME config key as api/notify.ts and backend/NotifyWorker.java, in a third language. Nothing
# imports anything here; the environment variable is the entire coupling.
class Notifier
  def endpoint
    ENV["NOTIFY_WEBHOOK_URL"]
  end
end
