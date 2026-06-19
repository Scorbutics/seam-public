class Billing
  def charge(state)
    Payment.create(amount: 100)
    save_data(state, 'Data/Bill.rxdata')
  end
end
