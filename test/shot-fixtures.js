// A saved recording contains preheat and a terminal state around the pump clock.
function timedMeasurements(timestamp, pumpSeconds) {
  const start = Date.parse(timestamp);
  const point = (seconds, substate) => ({ machine: {
    timestamp: new Date(start + seconds * 1000).toISOString(),
    state: { state: "espresso", substate }, pressure: 9, flow: 2,
    profileFrame: substate === "preinfusion" ? 0 : 1,
  } });
  const values = [point(0, "preparingForShot"), point(1, "preinfusion")];
  for (let second = 2; second < pumpSeconds + 1; second++)
    values.push(point(second, "pouring"));
  values.push(point(pumpSeconds + 1, "pouringDone"));
  return values;
}
module.exports = { timedMeasurements };
