export function conversationControlMode(conversation) {
  return Number.isFinite(Number(conversation?.desktopIndex)) ? "desktop" : "agent";
}

export function selectionStartState(conversation) {
  if (!conversation) {
    return {
      selected: null,
      messages: [],
      running: false,
      controlMode: "agent"
    };
  }

  return {
    selected: conversation,
    messages: [{ role: "system", text: "Reading local context." }],
    running: false,
    controlMode: conversationControlMode(conversation)
  };
}
