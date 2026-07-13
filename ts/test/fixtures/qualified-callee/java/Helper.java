package app;

public class Helper {
    public static void doWork(String x) {
        System.out.println(x);
    }
    public static void persist(String y) {
        Store.write(y);
    }
}
