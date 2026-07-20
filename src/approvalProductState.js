export function enrichApprovalProductState(approvals = [], executionBindings = [], providerRegistry = {}) {
  const providers = new Map((providerRegistry.providers || []).map((provider) => [provider.id, provider]));
  return approvals.map((approval) => {
    const execution = (
      approval.toolRunId && executionBindings.find((binding) => binding.toolRunId === approval.toolRunId)
    ) || (
      approval.taskId && executionBindings.find((binding) => binding.taskId === approval.taskId)
    ) || null;
    return {
      ...approval,
      execution,
      providerFidelity: providers.get(approval.provider)?.fidelity || null
    };
  });
}
