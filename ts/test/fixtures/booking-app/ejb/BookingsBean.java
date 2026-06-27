package acme;

// The data-layer bean — itself an in-repo wrapper that delegates to the ORM/repository. Followed by the grow.
public class BookingsBean {
  RecordRepo repo;
  public SubList getUpcomingBookings( String memberId ) { return repo.find( memberId ); }
  public Booking persist( Booking b ) { return repo.save( b ); }
}
