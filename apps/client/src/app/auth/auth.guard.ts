import { inject } from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { Router } from '@angular/router';
import { AuthStore } from './auth.store';

/** Lets signed-in users through; everyone else goes to `/login`. */
export const authGuard: CanActivateFn = () =>
  inject(AuthStore).signedIn() || inject(Router).createUrlTree(['/login']);
