FROM adminer:5

COPY autologin-router.php /var/www/autologin-router.php

CMD ["php", "-S", "[::]:8080", "-t", "/var/www/html", "/var/www/autologin-router.php"]
