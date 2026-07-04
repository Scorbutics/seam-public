package acme;
import javax.ws.rs.*;

// The MANAGE UI's backend resource (sibling of BookingsService, other route family). Same bean, different
// route base — the concern's "manage" half. Reproduces the two-route-family shape (manage + member).
@Path("/manage/rest/booking")
public class ManageBookingsService {

  @Inject BookingsBean mBookingsBean;

  @GET
  @Path("overrideOptions/{id}")
  public SubList overrideOptions( @PathParam("id") String memberId ) {
    return mBookingsBean.getUpcomingBookings( memberId );
  }

  @POST
  @Path("create")
  public Booking createBooking( Booking b ) {
    return mBookingsBean.persist( b );
  }
}
