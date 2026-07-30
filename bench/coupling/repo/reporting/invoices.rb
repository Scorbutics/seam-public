# Ruby reader of `invoices` — the other side of backend/InvoicePoster.java.
class InvoiceReport
  def due
    Invoice.where(state: "due").order(:created_at)
  end
end
