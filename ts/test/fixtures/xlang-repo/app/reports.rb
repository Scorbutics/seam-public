# Ruby ActiveRecord reader of `payments`.
class Reports
  def overdue
    Payment.where(status: "overdue").order(:created_at)
  end
end
