// Cloudflare Worker - API Proxy for OS NGD API and UK-wide LiDAR
// This worker securely proxies requests to the OS NGD API and routes LiDAR requests
// to appropriate regional WMS services based on geographic location

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    try {
      const url = new URL(request.url);
      
      // Get the API service type from query parameter
      const serviceType = url.searchParams.get('service');
      
      // Check if this is a WMS request (has BBOX, LAYERS, etc.)
      const hasWMSParams = url.searchParams.has('BBOX') || url.searchParams.has('bbox');
      const hasServiceParam = url.searchParams.has('SERVICE') || url.searchParams.has('service');
      
      // If it looks like a WMS request (has BBOX), treat it as LiDAR
      if (hasWMSParams && (serviceType === 'lidar' || hasServiceParam)) {
        return await this.handleLidarRequest(url, request);
      }
      
      if (!serviceType) {
        return new Response(
          JSON.stringify({ 
            error: 'Missing service parameter',
            usage: 'Add ?service=tiles, ?service=features, or ?service=lidar'
          }), 
          {
            status: 400,
            headers: { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          }
        );
      }

      // Handle LiDAR requests
      if (serviceType === 'lidar') {
        return await this.handleLidarRequest(url, request);
      }

      // Handle OS NGD API requests (existing functionality)
      let apiUrl;
      const apiKey = env.OS_NGD_API_KEY;
      
      if (serviceType === 'tiles') {
        // For vector tiles requests
        const collectionId = url.searchParams.get('collection') || 'ngd-base';
        const path = url.searchParams.get('path') || '';
        
        if (path) {
          // Tile or style request
          apiUrl = `https://api.os.uk/maps/vector/ngd/ota/v1/collections/${collectionId}/${path}?key=${apiKey}`;
        } else {
          // Base collection request
          apiUrl = `https://api.os.uk/maps/vector/ngd/ota/v1/collections/${collectionId}/styles/3857?key=${apiKey}`;
        }
      } else if (serviceType === 'features') {
        // For features API requests
        const path = url.searchParams.get('path') || '';
        apiUrl = `https://api.os.uk/features/ngd/ofa/v1/${path}?key=${apiKey}`;
      } else {
        return new Response(
          JSON.stringify({ 
            error: 'Invalid service type',
            validTypes: ['tiles', 'features', 'lidar']
          }), 
          {
            status: 400,
            headers: { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          }
        );
      }

      // Copy additional query parameters (except our custom ones)
      const additionalParams = new URLSearchParams();
      for (const [key, value] of url.searchParams) {
        if (!['service', 'collection', 'path'].includes(key)) {
          additionalParams.append(key, value);
        }
      }
      
      if (additionalParams.toString()) {
        apiUrl += '&' + additionalParams.toString();
      }

      console.log('Proxying request to:', apiUrl);

      // Make the request to the OS NGD API
      const apiResponse = await fetch(apiUrl, {
        method: request.method,
        headers: {
          'User-Agent': 'MapSketch-Proxy/1.0',
          'Accept': '*/*',
        },
      });

      // Get the response data
      const contentType = apiResponse.headers.get('content-type') || '';
      let responseBody;
      
      if (contentType.includes('application/json')) {
        // Handle style JSON - need to modify it for the proxy
        const data = await apiResponse.json();
        
        // If this is a style JSON with sources, modify it
        if (data.sources && serviceType === 'tiles') {
          const collectionId = url.searchParams.get('collection') || 'ngd-base';
          
          // Check if the source exists and has a url property
          if (data.sources[collectionId] && data.sources[collectionId].url) {
            // Extract the base URL without the key parameter
            const sourceUrl = data.sources[collectionId].url.replace(/\?key=[^&]+/, '');
            
            // Create tiles array pointing to our proxy
            data.sources[collectionId].tiles = [
              `${url.origin}?service=tiles&collection=${collectionId}&path=tiles/3857/{z}/{y}/{x}`
            ];
            
            // Remove the url property (as per OS NGD pattern)
            delete data.sources[collectionId].url;
          }
          
          // Remove center and zoom from style so Leaflet controls the view
          delete data.center;
          delete data.zoom;
        }
        
        // Remove API key from sprite and glyph URLs
        const jsonText = JSON.stringify(data);
        const cleaned = jsonText.replace(/\?key=[^"&]+/g, '').replace(/&key=[^"&]+/g, '');
        responseBody = cleaned;
      } else {
        // For binary data (tiles, images, etc.)
        responseBody = await apiResponse.arrayBuffer();
      }

      // Return the response with CORS headers
      return new Response(responseBody, {
        status: apiResponse.status,
        headers: {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600',
        },
      });

    } catch (error) {
      console.error('Proxy error:', error);
      
      return new Response(
        JSON.stringify({ 
          error: 'Proxy request failed',
          message: error.message
        }), 
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }
  },

  // Handle LiDAR WMS requests with regional routing
  async handleLidarRequest(url, request) {
    // Get WMS parameters
    const wmsRequest = url.searchParams.get('REQUEST') || url.searchParams.get('request');
    const bbox = url.searchParams.get('BBOX') || url.searchParams.get('bbox');
    
    // Determine which regional WMS to use based on bounding box
    let wmsUrl;
    let layers;
    
    if (bbox) {
      const region = this.detectRegion(bbox);
      const wmsConfig = this.getWMSConfig(region);
      wmsUrl = wmsConfig.url;
      layers = wmsConfig.layers;
    } else {
      // Default to England if no bbox provided
      const wmsConfig = this.getWMSConfig('england');
      wmsUrl = wmsConfig.url;
      layers = wmsConfig.layers;
    }

    // Build WMS request URL
    const wmsParams = new URLSearchParams();
    
    // Copy all parameters from original request, excluding our custom 'service' param
    for (const [key, value] of url.searchParams) {
      const lowerKey = key.toLowerCase();
      // Skip our custom service param, but keep WMS SERVICE param
      if (lowerKey === 'service' && value.toLowerCase() === 'lidar') {
        continue; // Skip our custom lidar service indicator
      }
      wmsParams.append(key, value);
    }
    
    // Ensure we have SERVICE=WMS if not already present
    if (!wmsParams.has('SERVICE') && !wmsParams.has('service')) {
      wmsParams.set('SERVICE', 'WMS');
    }
    
    // Override LAYERS parameter with regional layer
    wmsParams.set('LAYERS', layers);
    
    const fullWmsUrl = `${wmsUrl}?${wmsParams.toString()}`;
    
    console.log('Proxying LiDAR request to:', fullWmsUrl);

    try {
      // Forward the request to the appropriate WMS service
      const wmsResponse = await fetch(fullWmsUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'MapSketch-Proxy/1.0',
        },
      });

      // Return the WMS response
      const responseBody = await wmsResponse.arrayBuffer();
      const contentType = wmsResponse.headers.get('content-type') || 'image/png';

      return new Response(responseBody, {
        status: wmsResponse.status,
        headers: {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch (error) {
      console.error('LiDAR WMS error:', error);
      
      return new Response(
        JSON.stringify({ 
          error: 'LiDAR WMS request failed',
          message: error.message
        }), 
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }
  },

  // Detect which UK region based on bounding box
  detectRegion(bboxString) {
    // Parse BBOX - coordinates from Leaflet are in EPSG:3857 (Web Mercator)
    const coords = bboxString.split(',').map(parseFloat);
    
    if (coords.length !== 4) {
      return 'england'; // default
    }
    
    const [minX, minY, maxX, maxY] = coords;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    
    // Convert from EPSG:3857 (Web Mercator) to EPSG:4326 (lat/lon)
    let centerLon, centerLat;
    
    // Check if coordinates are in EPSG:3857 (values typically > 20000)
    if (Math.abs(centerX) > 20000 || Math.abs(centerY) > 20000) {
      // Convert EPSG:3857 to EPSG:4326
      // Web Mercator to WGS84 transformation
      const originShift = 2 * Math.PI * 6378137 / 2.0; // 20037508.342789244
      
      centerLon = (centerX / originShift) * 180.0;
      let latRad = (centerY / originShift) * Math.PI;
      centerLat = (Math.atan(Math.exp(latRad)) * 2 - Math.PI / 2) * (180.0 / Math.PI);
    } else {
      // Already in EPSG:4326
      centerLon = centerX;
      centerLat = centerY;
    }
    
    console.log(`Region detection: lon=${centerLon.toFixed(2)}, lat=${centerLat.toFixed(2)}`);
    
    // UK region boundaries in EPSG:4326 (lat/lon)
    
    // Scotland: roughly north of 55.3°N
    if (centerLat > 55.3) {
      console.log('Detected region: Scotland');
      return 'scotland';
    }
    
    // Wales: roughly between -5.5 to -2.5 longitude and 51.3 to 53.5 latitude
    if (centerLon < -2.5 && centerLat > 51.3 && centerLat < 53.5) {
      console.log('Detected region: Wales');
      return 'wales';
    }
    
    // Northern Ireland: roughly between -8.5 to -5.5 longitude and 54 to 55.5 latitude
    if (centerLon < -5.5 && centerLat > 54.0 && centerLat < 55.5) {
      console.log('Detected region: Northern Ireland');
      return 'northern_ireland';
    }
    
    // Default to England
    console.log('Detected region: England (default)');
    return 'england';
  },

  // Get WMS configuration for each region
  getWMSConfig(region) {
    const configs = {
      england: {
        url: 'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wms',
        layers: 'Lidar_Composite_Hillshade_DTM_1m'
      },
      scotland: {
        // Scotland: Using England service as fallback (Scotland's public WMS endpoints are unreliable)
        // TODO: Find stable Scotland LiDAR WMS or host tiles separately
        url: 'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wms',
        layers: 'Lidar_Composite_Hillshade_DTM_1m'
      },
      wales: {
        // Wales: Using England service as fallback (Wales data requires authentication)
        // TODO: Implement proper Wales NRW access or host tiles
        url: 'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wms',
        layers: 'Lidar_Composite_Hillshade_DTM_1m'
      },
      northern_ireland: {
        // Northern Ireland: Using England service (NI has very limited free coverage)
        url: 'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wms',
        layers: 'Lidar_Composite_Hillshade_DTM_1m'
      }
    };
    
    return configs[region] || configs.england;
  }
};

