package com.example;
public class PaymentView {
  String render(Payment payment) {
    return "fee: " + payment.getFee();
  }
}
