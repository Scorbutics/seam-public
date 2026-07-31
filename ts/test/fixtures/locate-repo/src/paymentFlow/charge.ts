// A module with NO barrel and no symbol named `paymentFlow` — the cal.com `handleNewBooking` shape.
export function charge(amount: number) {
  return amount;
}

// A DESCRIPTOR OBJECT: nested data keys the regex extractor used to report as `[function]`.
export const chargeQuery = {
  select: {
    id: true,
    amount: true,
  },
  include: {
    customer: true,
  },
};
