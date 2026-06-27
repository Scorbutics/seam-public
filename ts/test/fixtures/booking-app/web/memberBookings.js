// Booking SUMMARY screen (AngularJS-style): list bookings, resync and cancel. Reaches the backend ONLY over an
// HTTP route ($http.get of a route LITERAL) — the cross-stack boundary. This is the "summary" half of the intent.
function loadBookings( changeToList ) {
  $http.get( '/acme/rest/member/booking/v1/summarize/0/' + member._id ).then( function( result ) {
    scope.bookings = result.data;
  } );
}

function cancelBooking( id ) {
  $http.post( '/acme/rest/member/booking/v1/' + id + '/cancel' );
}
