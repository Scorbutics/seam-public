// The custom HTTP layer — a thin wrapper whose methods call the grounded sink `fetch`. Effect inference deduces
// it (and anything aliased to it) is an HTTP client, WITHOUT its name being fetch/axios.
export const httpService = {
  get( url ) { return fetch( url ); },
  post( url, body ) { return fetch( url, { method: 'POST', body } ); }
};
