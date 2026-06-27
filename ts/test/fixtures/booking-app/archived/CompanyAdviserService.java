package acme;
import javax.ws.rs.*;

// UNRELATED service whose bare relative @Path shares only the generic 'summarize' segment with the booking
// route. It must NOT be coupled to the booking flow (the route-specificity filter discards it).
@Path("/adviser")
public class CompanyAdviserService {
  @GET
  @Path("summarize/{id}")
  public String adviserSummary( @PathParam("id") String id ) { return null; }
}
