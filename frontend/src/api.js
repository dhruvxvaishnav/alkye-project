const BASE = import.meta.env.VITE_API_URL || '/api'
export async function request(path, { token, ...options } = {}) {
  const response = await fetch(`${BASE}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } })
  const data = await response.json()
  if (!response.ok) { const error = new Error(data.message || 'Something went wrong. Please try again.'); error.status = response.status; throw error }
  return data
}
export const post = (path, body, token) => request(path, { method: 'POST', body: JSON.stringify(body), token })
