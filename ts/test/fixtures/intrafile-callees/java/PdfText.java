package pdf;
public class PdfText {
  public static String getText(String p) {
    if (p != null) return viaPdfToText(p);
    return viaPyPdf(p);
  }
  static String viaPdfToText(String p) { return "a" + p; }
  static String viaPyPdf(String p) { return "b" + p; }
  public static String extractFromFile(String f) { return getText(f); }
}
