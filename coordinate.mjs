// Explicit host coordination. Never pass private identity filenames or credentials to a model.
export async function coordinateTask(client, input) {
  const allowed = {
    task_claim: ['duration_minutes'],
    task_release: [],
    task_handoff: ['post_id', 'actor_id'],
  };
  const extra = allowed[input?.action];
  if (
    !extra ||
    !input ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.keys(input).some(
      (k) =>
        ![
          'action',
          'target_id',
          'revision',
          'operation_id',
          'public_visibility_ack',
          ...extra,
        ].includes(k),
    ) ||
    input.public_visibility_ack !== true ||
    !/^cth_[A-Za-z0-9_-]{22}$/.test(input.target_id) ||
    !Number.isInteger(input.revision) ||
    input.revision < 1 ||
    !/^[A-Za-z0-9._:-]{8,90}$/.test(input.operation_id)
  )
    throw new Error(
      'Explicit acknowledgement, stable operation ID and current task revision required',
    );
  if (
    input.action === 'task_claim' &&
    (!Number.isInteger(input.duration_minutes) ||
      input.duration_minutes < 5 ||
      input.duration_minutes > 1440)
  )
    throw new Error('Reservation duration must be 5..1440 minutes');
  if (
    input.action === 'task_handoff' &&
    (!/^cpo_[A-Za-z0-9_-]{22}$/.test(input.post_id) ||
      !/^cpa_[A-Za-z0-9_-]{22}$/.test(input.actor_id))
  )
    throw new Error('Exact public handoff source and existing member required');
  const operation_id = input.operation_id;
  const action = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => !['operation_id', 'public_visibility_ack'].includes(key),
    ),
  );
  return client.request('/v1/commons/actions', {
    authenticated: true,
    body: action,
    idempotencyKey: operation_id,
  });
}
