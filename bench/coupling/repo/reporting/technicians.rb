# DECOY. Reads `technicians.status` — the same COLUMN NAME the TS API writes on `work_orders`, on a
# different table. Nothing about a work order's status has anything to do with a technician's. A tool that
# matches on column names rather than on the table couples these two and is wrong.
class TechnicianReport
  def active
    Technician.where(status: "active")
  end
end
