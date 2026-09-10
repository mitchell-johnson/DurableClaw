// Node unit tests import the Worker router. Real DO behavior is tested separately
// in workerd; Node only needs the exported class to be loadable.
export class DurableObject<Env> {
  constructor(
    protected ctx: DurableObjectState,
    protected env: Env,
  ) {}
}
