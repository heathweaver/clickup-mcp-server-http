import axios from 'axios';
import { Request, Response, NextFunction } from 'express';

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export class GitHubAuth {
  private config: AuthConfig;

  constructor(config: AuthConfig) {
    this.config = config;
  }

  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.callbackUrl,
      state,
      scope: 'user:email',
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  }

  async exchangeCodeForToken(code: string): Promise<string> {
    try {
      const response = await axios.post(
        'https://github.com/login/oauth/access_token',
        {
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code,
          redirect_uri: this.config.callbackUrl,
        },
        {
          headers: {
            Accept: 'application/json',
          },
        }
      );

      if (response.data.error) {
        throw new Error(response.data.error_description || 'OAuth error');
      }

      return response.data.access_token;
    } catch (error) {
      console.error('Error exchanging code for token:', error);
      throw error;
    }
  }

  async getUserInfo(accessToken: string): Promise<any> {
    try {
      const response = await axios.get('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });
      return response.data;
    } catch (error) {
      console.error('Error getting user info:', error);
      throw error;
    }
  }

  requireAuth() {
    return (req: Request, res: Response, next: NextFunction) => {
      const session = req.session as any;
      
      if (!session.accessToken) {
        return res.status(401).json({ 
          error: 'Unauthorized',
          message: 'Authentication required. Please visit /auth/login to authenticate.' 
        });
      }
      
      next();
    };
  }
}

