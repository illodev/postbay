import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, type Me, type Role } from '../api';
import { can as canDo, type Permission } from './permissions';

type BrandInfo = Me['brands'][number];

interface Session {
  me: Me;
  brand: BrandInfo;
  role: Role;
  setBrandId: (id: string) => void;
  can: (p: Permission) => boolean;
}

const Ctx = createContext<Session | null>(null);
const KEY = 'studio.brand';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/api/me'),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
  });
}

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const [brandId, setId] = useState<string | null>(() => {
    try { return localStorage.getItem(KEY); } catch { return null; }
  });
  const brand = me.brands.find((b) => b.id === brandId) ?? me.brands[0]!;
  const setBrandId = useCallback((id: string) => {
    setId(id);
    try { localStorage.setItem(KEY, id); } catch { /* private mode: the choice just will not stick */ }
  }, []);
  const value = useMemo<Session>(
    () => ({ me, brand, role: brand.role, setBrandId, can: (p) => canDo(brand.role, p) }),
    [me, brand, setBrandId],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
