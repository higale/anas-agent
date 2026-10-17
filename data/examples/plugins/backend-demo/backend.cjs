let count = 0
module.exports = {
  async activate() { count = 0 },
  async call(method, params) {
    if (method === 'count') return { count: ++count, received: params }
    if (method === 'fail') throw new Error('Example backend error')
    throw new Error('Unknown method')
  },
  async deactivate() { /* Close owned connections and child processes here. */ }
}
