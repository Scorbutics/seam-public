# GLOBAL var: the app stashes the instance in $game (very common in Ruby games/PSDK).
$game = GameState.new
def global_caller
  $game.save
end
