<?php

namespace App\Test;

interface LoggerInterface {
    public function log(string $message): void;
    public function debug(string $message): void;
}

class FileLogger implements LoggerInterface {
    public function log(string $message): void {
        file_put_contents('log.txt', $message);
    }
    
    public function debug(string $message): void {
        $this->log("[DEBUG] " . $message);
    }
}

class DatabaseLogger implements LoggerInterface {
    public function log(string $message): void {
        // Save to database
    }
    
    public function debug(string $message): void {
        $this->log("[DEBUG] " . $message);
    }
}

class Application {
    public function run(LoggerInterface $logger) {
        $logger->log("Application started");
        $logger->debug("Debugging info");
    }
}
