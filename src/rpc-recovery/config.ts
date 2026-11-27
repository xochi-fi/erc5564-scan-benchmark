export { filter, hex, identity, type LogIdentity } from '../shared/announcer.ts';
export { rpc, scope, type Window } from '../shared/base-windows.ts';

export const origin = "http://127.0.0.1:8784";
export const control = "http://127.0.0.1:8785";
export const chainVolumeIdentity = (id: string) => {
  const [block, , tx, index] = id.split(":");
  return [block, index, tx].join(":");
};
