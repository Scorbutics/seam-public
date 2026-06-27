package acme;
import javax.ws.rs.*;

// JAX-RS backend resource. Both UI screens cross to it over the shared route base: the summary's
// $http.get(.../summarize/...) and the declarative client's create/update endpoint-map entries.
@Path("/acme/rest/member/booking/v1")
public class BookingsService {

  // a DI-injected REPOSITORY whose type is an in-repo class — the grow follows it, so coupling should NOT
  // flag it per-repository (the blindspot gate drops it); the boundary is the ORM it delegates to.
  @Inject BookingsBean mBookingsBean;

  @GET
  @Path("summarize/{page}/{id}")
  public SubList paginate( @PathParam("id") String memberId ) {
    return mBookingsBean.getUpcomingBookings( memberId );
  }

  @POST
  public Booking create( Booking b ) {
    return mBookingsBean.persist( b );
  }

  @PUT
  @Path("{id}")
  public Booking update( @PathParam("id") String id, Booking b ) {
    return mBookingsBean.persist( b );
  }
}
