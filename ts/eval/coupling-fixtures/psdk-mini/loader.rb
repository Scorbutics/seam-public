def save_data(data, filename)
  File.binwrite(filename, Marshal.dump(data))
end
def load_data(filename)
  Marshal.load(File.binread(filename))
end
