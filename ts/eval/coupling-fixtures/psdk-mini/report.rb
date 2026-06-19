class Report
  def totals
    Payment.where(paid: true)
  end
end
