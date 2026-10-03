/** Match a request media type while allowing ordinary parameters such as charset. */
export function hasMediaType(request, expected) {
  const value = request.headers.get('content-type');
  if (!value) return false;
  return value.split(';', 1)[0].trim().toLowerCase() === expected;
}
