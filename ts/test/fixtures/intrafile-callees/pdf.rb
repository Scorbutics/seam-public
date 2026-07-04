def get_text(p)
  return via_pdftotext(p) if p
  via_pypdf(p)
end
def via_pdftotext(p); "a"; end
def via_pypdf(p); "b"; end
def extract_from_file(f); get_text(f); end
