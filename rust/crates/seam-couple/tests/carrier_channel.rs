//! The carrier axis end-to-end on a hermetic Ruby repo — the Rust twin of
//! `ts/test/coupling/carrier_channel.test.ts`, asserting the same claims against the ported engine:
//! teacher 1 (trace a homemade wrapper to a Marshal/File sink), teacher 2 (an interpolated path becomes a
//! family pattern that meets a literal writer), and the code-loader exclusion (a wrapper that `eval`s what
//! it reads is not a data channel).

// Each test uses its OWN tmp repo path, so the engine's per-repo memo cannot leak between them (and no
// global reset is needed, which would race under the parallel test runner).
use seam_couple::carrier::{anchor_carrier_accs, carrier_channel_index, CarrierOpts};

struct Repo(std::path::PathBuf);

impl Repo {
    fn new(tag: &str) -> Repo {
        let dir = std::env::temp_dir().join(format!("seam-carrier-rs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Repo(dir)
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.0.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    fn path(&self) -> &str {
        self.0.to_str().unwrap()
    }
}

impl Drop for Repo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fixture(tag: &str) -> Repo {
    let r = Repo::new(tag);
    // homemade I/O primitives (carriers) — bottom out at File + Marshal sinks.
    r.write(
        "lib/loader.rb",
        "def save_data(data, filename)\n  File.binwrite(filename, Marshal.dump(data))\nend\ndef load_data(filename)\n  Marshal.load(File.binread(filename))\nend\n",
    );
    // a WRITER: calls save_data with a literal path → produces 'Data/Save.rxdata'
    r.write("lib/saver.rb", "class Saver\n  def snapshot(state)\n    save_data(state, 'Data/Save.rxdata')\n  end\nend\n");
    // a READER (no import/call link to the writer): calls load_data with the SAME literal → consumes it
    r.write("lib/boot.rb", "class Boot\n  def restore\n    @save = load_data('Data/Save.rxdata')\n  end\nend\n");
    // a CODE-LOADER wrapper: reads a .rb file to EVAL it — a read sink, but loads code, not data.
    r.write(
        "lib/deps.rb",
        "def load_dependency(name)\n  code = File.read(\"lib/#{name}.rb\")\n  eval(code)\nend\ndef boot_deps\n  load_dependency('rbconfig')\nend\n",
    );
    // TEACHER 2: a literal WRITER and an INTERPOLATED reader over the same family `Data/Text/*.dat`.
    r.write("lib/text_writer.rb", "class TextWriter\n  def dump_en(t)\n    save_data(t, 'Data/Text/en.dat')\n  end\nend\n");
    r.write("lib/text_reader.rb", "class TextReader\n  def load(lang)\n    load_data(\"Data/Text/#{lang}.dat\")\n  end\nend\n");
    r
}

#[test]
fn couples_writer_and_reader_across_the_shared_data_file_key() {
    let r = fixture("couple");
    let idx = carrier_channel_index(r.path(), &CarrierOpts::default());
    let entry = idx.get("data-file Data/Save.rxdata").expect("the shared key must be grounded");
    assert!(entry.producers.iter().any(|p| p.file == "lib/saver.rb"), "producers: {:?}", entry.producers);
    assert!(entry.consumers.iter().any(|c| c.file == "lib/boot.rb"), "consumers: {:?}", entry.consumers);
}

#[test]
fn anchor_accs_report_the_writers_produced_key() {
    let r = fixture("accs");
    let text = "class Saver\n  def snapshot(state)\n    save_data(state, 'Data/Save.rxdata')\n  end\nend\n";
    let accs = anchor_carrier_accs(r.path(), "lib/saver.rb", text, 0, 99);
    assert_eq!(accs.len(), 1, "{accs:?}");
    assert_eq!(accs[0].kind, "data-file");
    assert_eq!(accs[0].value, "Data/Save.rxdata");
    assert!(accs[0].produces);
    assert_eq!(accs[0].line, 2);
}

#[test]
fn teacher2_interpolated_path_becomes_a_partial_family_pattern() {
    let r = fixture("interp");
    let accs = anchor_carrier_accs(r.path(), "x.rb", "def go(lang)\n  load_data(\"Data/Text/#{lang}.dat\")\nend\n", 0, 9);
    assert_eq!(accs.len(), 1, "{accs:?}");
    assert_eq!(accs[0].value, "Data/Text/*.dat");
    assert!(!accs[0].produces);
    assert_eq!(accs[0].line, 1);
}

#[test]
fn a_fully_dynamic_key_yields_nothing() {
    let r = fixture("dynamic");
    let accs = anchor_carrier_accs(r.path(), "x.rb", "def go(p)\n  load_data(\"#{p}\")\nend\n", 0, 9);
    assert!(accs.is_empty(), "{accs:?}");
}

#[test]
fn a_code_loader_is_not_a_data_file_key() {
    let r = fixture("codeload");
    let idx = carrier_channel_index(r.path(), &CarrierOpts::default());
    assert!(!idx.contains_key("data-file rbconfig"), "'rbconfig' loads code, not data");
}

#[test]
fn teacher2_interpolated_reader_couples_to_a_literal_writer_via_the_family_pattern() {
    let r = fixture("family");
    let idx = carrier_channel_index(r.path(), &CarrierOpts::default());
    // the literal writer grounds on the recovered family pattern key…
    let fam = idx.get("data-file Data/Text/*.dat").expect("family key");
    assert!(fam.producers.iter().any(|p| p.file == "lib/text_writer.rb"), "{:?}", fam.producers);
    assert!(fam.consumers.iter().any(|c| c.file == "lib/text_reader.rb"), "{:?}", fam.consumers);
    // …and the interpolated reader also grounds on the concrete literal key (symmetric expansion)
    let lit = idx.get("data-file Data/Text/en.dat").expect("literal key");
    assert!(lit.producers.iter().any(|p| p.file == "lib/text_writer.rb"), "{:?}", lit.producers);
    assert!(lit.consumers.iter().any(|c| c.file == "lib/text_reader.rb"), "{:?}", lit.consumers);
}
