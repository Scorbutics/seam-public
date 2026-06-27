package acme;

// The repository leaf — the deepest in-repo data layer (would delegate to the actual driver/EntityManager).
public class RecordRepo {
  public SubList find( String id ) { return null; }
  public Booking save( Booking b ) { return null; }
}
