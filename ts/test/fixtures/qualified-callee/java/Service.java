package app;

public class Service {
    public void handle(String req) {
        Helper.doWork(req);
        Helper.persist(req);
        Helper.missingMethod(req);
    }
}
