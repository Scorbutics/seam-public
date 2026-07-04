# QUALIFIED module accessor: PFM.game.save (the PSDK idiom the memory flags).
module PFM
  def self.game
    $game
  end
end
def qualified_caller
  PFM.game.save
end
