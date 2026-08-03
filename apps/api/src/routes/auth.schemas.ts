import { z } from 'zod';

/**
 * Why validate here with Zod instead of trusting the frontend to send
 * well-formed data?
 *
 * The frontend is not a trust boundary. Anyone can POST directly to this
 * API with curl, Postman, or a modified client — validation must happen
 * at the server boundary regardless of what the UI does. Zod gives us a
 * single schema that both validates *and* produces a typed result, so the
 * route handler never touches an untyped `req.body`.
 */
export const registerSchema = z.object({
  email: z.string().trim().email('Must be a valid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
});

export const loginSchema = z.object({
  email: z.string().trim().email('Must be a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;
