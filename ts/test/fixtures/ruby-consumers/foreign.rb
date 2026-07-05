# NAME COLLISION: a different class with its OWN `save` — `Other.new.save` must NOT read as a GameState
# consumer (provably-foreign receiver: the instance is an Other, dispatching to Other#save).
class Other
  def save
    "other-saved"
  end
end
def foreign_caller
  Other.new.save
end
