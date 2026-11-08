# Four-way traffic light

- Crossing roads are never allowed to go at once: north-south and east-west
  are never both green or yellow at the same instant.
- Every light changes in the order green, yellow, red, green. It never skips
  yellow, and it never goes from red to yellow.
- Between one road going red and the other going green there is a moment when
  both are red, so a car that ran the yellow has time to clear.
- Both roads get a green in every full cycle; neither waits forever.
- The controller never reads the real clock. Time comes only from the `now`
  function it is given.
- The page says each light's state in words, not only by color, so someone who
  can't tell red from green can still read it.
- However emergency requests, clears, faults and recoveries are interleaved with
  the cycle, crossing roads are never both green or yellow in any reachable
  state.
