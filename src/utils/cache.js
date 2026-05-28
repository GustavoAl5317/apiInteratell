/**
 * Cache simples em memória com TTL (tempo de expiração).
 * Evita chamadas repetidas ao Bitrix24 para dados que mudam pouco.
 */
class TTLCache {
  constructor(ttlMs = 5 * 60 * 1000) {
    this.store = new Map();
    this.ttl = ttlMs;
  }

  set(key, value) {
    this.store.set(String(key), { value, expires: Date.now() + this.ttl });
  }

  get(key) {
    const entry = this.store.get(String(key));
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.store.delete(String(key));
      return undefined;
    }
    return entry.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  /** Retorna do cache se existir, senão executa fn(), armazena e retorna. */
  async getOrSet(key, fn) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const result = await fn();
    this.set(key, result);
    return result;
  }
}

module.exports = TTLCache;
