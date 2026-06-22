package com.example;
public class AmountView {
  String render(Payment payment) {
    return "amount: " + payment.getAmount();
  }
}
