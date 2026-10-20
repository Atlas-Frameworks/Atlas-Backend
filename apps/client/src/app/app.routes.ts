import type { Routes } from '@angular/router';
import { authGuard } from './auth/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    title: 'Atlas · Sign in',
    loadComponent: () => import('./login/login-page').then((m) => m.LoginPage),
  },
  {
    path: 'dev/map-bench',
    title: 'Atlas · Map benchmark',
    loadComponent: () => import('./dev/map-bench-page').then((m) => m.MapBenchPage),
  },
  {
    path: '',
    pathMatch: 'full',
    title: 'Atlas',
    canActivate: [authGuard],
    loadComponent: () => import('./workspace/workspace-page').then((m) => m.WorkspacePage),
  },
  { path: '**', redirectTo: '' },
];
