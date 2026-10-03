// Herdr owns prompt submission and readiness. A rejection is returned to the
// caller; no terminal screen text triggers a fallback or another submission.
export async function promptAgent(herdr, id, text) {
  return herdr.call('agent.prompt', {target:id,text});
}
