import { httpService } from './httpService';

// `MyFramework.http` is a CUSTOM client name (not fetch/axios), assigned the fetch-wrapping httpService — so a
// `MyFramework.http.<verb>('/route')` call must be recognised as an HTTP edge transitively, not by its name.
MyFramework.http = httpService;

export async function listBookingsViaFramework() {
  return MyFramework.http.get( '/acme/rest/member/booking/v1' );
}
