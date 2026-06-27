import { httpService } from './httpService';

// `MyFramework.http` is a CUSTOM client name (not fetch/axios), assigned the fetch-wrapping httpService — so a
// `MyFramework.http.<verb>('/route')` call must be recognised as an HTTP edge transitively, not by its name.
MyFramework.http = httpService;

export async function listBookingsViaFramework() {
  return MyFramework.http.get( '/acme/rest/member/booking/v1' );   // literal arg — the channel-matcher path
}

// The HARD shape: a declarative descriptor map + an INDIRECTED call — a dynamic verb AND a config reference, no
// literal route at the call site. The edge is proven (MyFramework.http is an inferred client); the route is
// resolved from this in-file `{ endpoint, method }` map — `bookingEndpoints.createBooking.endpoint`.
const baseUrl = '/acme/rest/member/booking/v1';
const bookingEndpoints = {
  createBooking: { endpoint: baseUrl, method: 'post' },
  updateBooking: { endpoint: baseUrl + '/{id}', method: 'put' }
};

export async function createBookingViaFramework( state ) {
  const method = bookingEndpoints.createBooking.method;
  return MyFramework.http[ method ]( bookingEndpoints.createBooking.endpoint, state );
}
