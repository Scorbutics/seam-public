const apiWrapper = require( '../utils/apiWrapper' );

/**
 * Service for booking CRUD: create, update and cancel a booking (the "details screen" half of the intent).
 * A DECLARATIVE API client — the operations are an { endpoint, method } config map fired through a generic
 * wrapper (Vue.http[method](endpoint)), so the route literal lives in the config, never at a $http.post call.
 */
module.exports = {
  install( Vue ) {
    const baseUrl = '/acme/rest/member/booking/v1';

    const bookingEndpoints = {
      "getBookings":   { endpoint: baseUrl,                method: 'get'  },
      "createBooking": { endpoint: baseUrl,                method: 'post' },
      "updateBooking": { endpoint: baseUrl + '/{id}',      method: 'put'  }
    };

    Vue.prototype.bookingService = {
      /** Create a new booking. */
      async createBooking( vm, bookingData ) {
        const endpoint = bookingEndpoints.createBooking.endpoint;
        const method = bookingEndpoints.createBooking.method;
        return apiWrapper( vm, () => Vue.http[method]( endpoint, bookingData ).then( r => r.data ) );
      },
      /** Update an existing booking. */
      async updateBooking( vm, bookingId, bookingData ) {
        const endpoint = bookingEndpoints.updateBooking.endpoint.replace( '{id}', bookingId );
        const method = bookingEndpoints.updateBooking.method;
        return apiWrapper( vm, () => Vue.http[method]( endpoint, bookingData ).then( r => r.data ) );
      }
    };
  }
};
