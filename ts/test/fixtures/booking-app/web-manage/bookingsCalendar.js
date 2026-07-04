// The MANAGE UI booking calendar (AngularJS-style). Consumes the manage route family. Reaches the backend over
// HTTP route literals — one SPECIFIC (grounds to the manage handler) and one GENERIC wildcard base built from a
// variable (`/manage/rest/booking/` + op) that matches no specific @Path → the grounding gap.
function loadOverrideOptions( id ) {
  return $http.get( '/manage/rest/booking/overrideOptions/' + id );
}

function createBooking( data ) {
  return $http.post( '/manage/rest/booking/create', data );
}

function dispatch( op, data ) {
  return $http.post( '/manage/rest/booking/' + op, data );   // generic base — no specific producer
}
