import { beforeEach, describe, expect, it, vi } from 'vitest'
import { post, request } from './api'

const fetchMock = vi.fn()
beforeEach(() => vi.stubGlobal('fetch', fetchMock))
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

describe('API client', () => {
  it('sends the JWT in authenticated requests and returns API data', async () => {
    const data = { tasks: [{ id: 7, title: 'From Rust' }], cache: { hit: true } }
    fetchMock.mockResolvedValue(response(data))
    await expect(request('/tasks/view-my-tasks', { token: 'staff-jwt' })).resolves.toEqual(data)
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/view-my-tasks', expect.objectContaining({
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer staff-jwt' },
    }))
  })

  it('serializes POST bodies without adding authorization to login', async () => {
    fetchMock.mockResolvedValue(response({ login_challenge_id: 'challenge-1' }))
    const credentials = { email: 'admin@example.com', password: 'Password123!' }
    await post('/auth/login', credentials)
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST', body: JSON.stringify(credentials), headers: { 'Content-Type': 'application/json' },
    }))
  })

  it('retains the actual 403 status and server message', async () => {
    fetchMock.mockResolvedValue(response({ message: 'The task creation rights are reserved for admins' }, 403))
    await expect(post('/tasks', { title: '', priority: 'medium' }, 'staff-jwt')).rejects.toMatchObject({
      status: 403, message: 'The task creation rights are reserved for admins',
    })
  })

  it('forwards PATCH bodies and the development email cache policy', async () => {
    fetchMock.mockResolvedValue(response({}))
    await request('/tasks/7/status', { method: 'PATCH', body: JSON.stringify({ status: 'completed' }), token: 'jwt' })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/tasks/7/status', expect.objectContaining({ method: 'PATCH', body: '{"status":"completed"}' }))
    await request('/dev/email-logs/latest', { cache: 'no-store' })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/dev/email-logs/latest', expect.objectContaining({ cache: 'no-store' }))
  })

  it('propagates network failures', async () => {
    fetchMock.mockRejectedValue(new Error('Network unavailable'))
    await expect(request('/tasks')).rejects.toThrow('Network unavailable')
  })
})
